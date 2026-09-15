import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { isProductionAllowed } from '../v1/tasks/production-policy';
import { CheckItem, PreflightReport, Quote, WorkflowIntent } from './workflow-contract';
import { TaskBudgetService } from './task-budget.service';
import { TaskQuoteService } from './task-quote.service';
import { isValidPricingSelection } from './pricing-catalog';
import { WorkflowCatalogService, workflowDigest } from './workflow-catalog.service';

export const PREFLIGHT_RECORD_TTL_MS = 30 * 60 * 1000;

export class PreflightRecordError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PreflightRecordError';
  }
}

function blocker(code: string, path: string, message = code): CheckItem {
  return { code, path, status: 'failed', message };
}

function json<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function comparableQuote(quote: Quote): Omit<Quote, 'expiresAt' | 'quoteDigest'> {
  const { expiresAt: _expiresAt, quoteDigest: _quoteDigest, ...value } = quote;
  return value;
}

@Injectable()
export class PreflightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: TaskBudgetService,
    private readonly catalog: WorkflowCatalogService,
    private readonly quotes: TaskQuoteService,
  ) {}

  async preview(actorId: string, intent: unknown): Promise<PreflightReport> {
    const evaluated = this.catalog.evaluate(intent);
    const createdAt = new Date();
    const quote = this.quotes.quote(evaluated.effectiveRequest, evaluated.model, createdAt);
    const expiresAt = new Date(Math.min(
      createdAt.getTime() + PREFLIGHT_RECORD_TTL_MS,
      new Date(quote.expiresAt).getTime(),
    ));
    const productionAdmission = await this.admission(actorId, evaluated.workflow, evaluated.requestCheck.status, quote);
    const preflightId = randomUUID();
    const report: PreflightReport = {
      preflightId,
      expiresAt: expiresAt.toISOString(),
      requestCheck: evaluated.requestCheck,
      productionAdmission,
      effectiveRequest: evaluated.effectiveRequest,
      model: evaluated.model,
      workflowVersion: evaluated.workflowVersion,
      contractDigest: evaluated.contractDigest,
      intentDigest: evaluated.intentDigest,
      quote,
      willUploadMedia: false,
      willCallProvider: false,
    };

    const record = await this.prisma.preflightRecord.create({
      data: {
        id: preflightId,
        actorId,
        createdAt,
        expiresAt,
        contractVersion: evaluated.effectiveRequest.contractVersion,
        workflowVersion: evaluated.workflowVersion,
        contractDigest: evaluated.contractDigest,
        intentDigest: evaluated.intentDigest,
        quoteDigest: quote.quoteDigest,
        effectiveRequest: evaluated.effectiveRequest as unknown as Prisma.InputJsonValue,
        report: report as unknown as Prisma.InputJsonValue,
        quoteSnapshot: quote as unknown as Prisma.InputJsonValue,
      },
    });
    return { ...report, preflightId: record.id };
  }

  async check(actorId: string, preflightId: string): Promise<PreflightReport> {
    const record = await this.prisma.preflightRecord.findFirst({ where: { id: preflightId, actorId } });
    if (!record) throw new PreflightRecordError('PREFLIGHT_REQUIRED');
    const stored = json<PreflightReport>(record.report);
    const quoteSnapshot = json<Quote>(record.quoteSnapshot);
    const { quoteDigest: _storedDigest, ...quoteBasis } = quoteSnapshot;
    const evaluated = this.catalog.evaluate(record.effectiveRequest);
    const blockers: CheckItem[] = [];
    let requestCheck = evaluated.requestCheck as PreflightReport['requestCheck'];
    if (record.expiresAt.getTime() <= Date.now()) {
      requestCheck = { ...requestCheck, status: 'incomplete' };
      blockers.push(blocker('PREFLIGHT_EXPIRED', 'expiresAt'));
    }
    if (record.contractDigest !== evaluated.contractDigest) {
      requestCheck = { ...requestCheck, status: 'incomplete' };
      blockers.push(blocker('PREFLIGHT_CONTRACT_CHANGED', 'contractDigest'));
    }
    if (new Date(quoteSnapshot.expiresAt).getTime() <= Date.now()) {
      requestCheck = { ...requestCheck, status: 'incomplete' };
      blockers.push(blocker('PREFLIGHT_QUOTE_EXPIRED', 'quote.expiresAt'));
    }
    const currentQuote = this.quotes.quote(evaluated.effectiveRequest, evaluated.model, new Date());
    if (workflowDigest(comparableQuote(currentQuote)) !== workflowDigest(comparableQuote(quoteSnapshot))) {
      requestCheck = { ...requestCheck, status: 'incomplete' };
      blockers.push(blocker('PREFLIGHT_QUOTE_CHANGED', 'quote.quoteDigest'));
    }
    const quoteSnapshotValid = record.quoteDigest === quoteSnapshot.quoteDigest
      && record.quoteDigest === workflowDigest(quoteBasis)
      && workflowDigest(quoteSnapshot) === workflowDigest(stored.quote);
    if (record.intentDigest !== evaluated.intentDigest || !quoteSnapshotValid) {
      requestCheck = { ...requestCheck, status: 'incomplete' };
      blockers.push(blocker('PREFLIGHT_RECORD_INVALID', 'preflightId'));
    }
    const current = await this.admission(actorId, evaluated.workflow, requestCheck.status, quoteSnapshot);
    blockers.push(...current.blockers);
    return {
      ...stored,
      preflightId: record.id,
      requestCheck,
      productionAdmission: { canSubmit: blockers.length === 0, blockers },
      effectiveRequest: evaluated.effectiveRequest,
      contractDigest: evaluated.contractDigest,
      intentDigest: evaluated.intentDigest,
      quote: quoteSnapshot,
      willUploadMedia: false,
      willCallProvider: false,
    };
  }

  /**
   * Resolve the immutable, currently admissible snapshot consumed by a formal
   * submission. Passing a transaction store makes the same validation run
   * under the budget/admission locks immediately before Task creation.
   */
  async prepareSubmission(
    actorId: string,
    preflightId: string,
    expected?: { intentDigest: string; quoteDigest: string },
    store?: Pick<Prisma.TransactionClient, 'preflightRecord'>,
  ) {
    const db = store ?? this.prisma;
    const record = await db.preflightRecord.findFirst({ where: { id: preflightId, actorId } });
    if (!record) throw new PreflightRecordError('PREFLIGHT_REQUIRED');
    if (expected && record.intentDigest !== expected.intentDigest) throw new PreflightRecordError('PREFLIGHT_INTENT_MISMATCH');
    if (expected && record.quoteDigest !== expected.quoteDigest) throw new PreflightRecordError('PREFLIGHT_QUOTE_MISMATCH');

    const now = new Date();
    if (record.expiresAt.getTime() <= now.getTime()) throw new PreflightRecordError('PREFLIGHT_EXPIRED');
    const quote = json<Quote>(record.quoteSnapshot);
    if (new Date(quote.expiresAt).getTime() <= now.getTime()) throw new PreflightRecordError('PREFLIGHT_QUOTE_EXPIRED');
    if (quote.status === 'unavailable' || quote.reserveCny === null || !quote.pricingVersion) {
      throw new PreflightRecordError('QUOTE_UNAVAILABLE');
    }

    const { quoteDigest: _quoteDigest, ...quoteBasis } = quote;
    const storedReport = json<PreflightReport>(record.report);
    if (
      record.quoteDigest !== quote.quoteDigest
      || record.quoteDigest !== workflowDigest(quoteBasis)
      || workflowDigest(storedReport.quote) !== workflowDigest(quote)
      || !isValidPricingSelection(quote.basis.pricingSnapshot)
    ) {
      throw new PreflightRecordError('PREFLIGHT_RECORD_INVALID');
    }
    const evaluated = this.catalog.evaluate(record.effectiveRequest);
    if (evaluated.requestCheck.status !== 'passed') throw new PreflightRecordError('REQUEST_INVALID');
    if (record.contractDigest !== evaluated.contractDigest) throw new PreflightRecordError('PREFLIGHT_CONTRACT_CHANGED');
    if (record.intentDigest !== evaluated.intentDigest) throw new PreflightRecordError('PREFLIGHT_RECORD_INVALID');
    const currentQuote = this.quotes.quote(evaluated.effectiveRequest, evaluated.model, now);
    if (workflowDigest(comparableQuote(currentQuote)) !== workflowDigest(comparableQuote(quote))) {
      throw new PreflightRecordError('PREFLIGHT_QUOTE_CHANGED');
    }
    if (!isProductionAllowed(actorId)) throw new PreflightRecordError('PRODUCTION_NOT_ALLOWED');
    if (evaluated.workflow.state.capability !== 'confirmed') throw new PreflightRecordError('WORKFLOW_CAPABILITY_UNCONFIRMED');
    if (evaluated.workflow.state.implementation !== 'ready') throw new PreflightRecordError('WORKFLOW_NOT_READY');
    if (!evaluated.workflow.state.admission.enabled) throw new PreflightRecordError('WORKFLOW_NOT_ENABLED');

    return {
      preflightId: record.id,
      actorId,
      effectiveRequest: evaluated.effectiveRequest,
      workflowVersion: evaluated.workflowVersion,
      contractDigest: evaluated.contractDigest,
      intentDigest: evaluated.intentDigest,
      model: evaluated.model,
      providerFields: evaluated.workflow.providerFields,
      quote,
    };
  }

  private async admission(
    actorId: string,
    workflow: ReturnType<WorkflowCatalogService['list']>[number],
    requestStatus: PreflightReport['requestCheck']['status'],
    quote: Quote,
  ): Promise<PreflightReport['productionAdmission']> {
    const blockers: CheckItem[] = [];
    if (requestStatus !== 'passed') blockers.push(blocker('REQUEST_INVALID', 'requestCheck'));
    if (!isProductionAllowed(actorId)) blockers.push(blocker('PRODUCTION_NOT_ALLOWED', 'productionAdmission.actor'));
    if (workflow.state.capability !== 'confirmed') blockers.push(blocker('WORKFLOW_CAPABILITY_UNCONFIRMED', 'workflowKey'));
    if (workflow.state.implementation !== 'ready') blockers.push(blocker('WORKFLOW_NOT_READY', 'workflowKey'));
    if (!workflow.state.admission.enabled) blockers.push(blocker('WORKFLOW_NOT_ENABLED', 'workflowKey', workflow.state.admission.reason ?? 'WORKFLOW_NOT_ENABLED'));
    if (quote.status === 'unavailable' || quote.reserveCny === null) blockers.push(blocker('QUOTE_UNAVAILABLE', 'quote'));
    const availability = await this.budget.preflightAvailability(actorId, quote.reserveCny ?? '0');
    if (!availability.canProceed) blockers.push(blocker(availability.reason ?? 'PRODUCTION_ADMISSION_REJECTED', 'productionAdmission.budget'));
    return { canSubmit: blockers.length === 0, blockers };
  }
}
