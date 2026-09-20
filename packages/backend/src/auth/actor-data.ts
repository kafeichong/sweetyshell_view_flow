interface CountDelegate {
  count(args: any): Promise<number>;
}

export interface ActorDataStore {
  task: CountDelegate;
  asset: CountDelegate;
  taskBudgetReservation: CountDelegate;
  preflightRecord: CountDelegate;
  costAlert: CountDelegate;
  costReconciliation: CountDelegate;
  tokenUsageLog: CountDelegate;
}

export async function hasActorBusinessData(store: ActorDataStore, actorId: string) {
  const counts = await Promise.all([
    store.task.count({
      where: { OR: [{ actorId }, { createdBy: actorId }] },
    }),
    store.asset.count({ where: { ownerId: actorId } }),
    store.taskBudgetReservation.count({ where: { actorId } }),
    store.preflightRecord.count({ where: { actorId } }),
    store.costAlert.count({ where: { actorId } }),
    store.costReconciliation.count({ where: { actorId } }),
    store.tokenUsageLog.count({ where: { actorId } }),
  ]);

  return counts.some((count) => count > 0);
}
