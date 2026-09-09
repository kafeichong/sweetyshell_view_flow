import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  async create(data: {
    createdBy: string;
    prompt: string;
    imageUrl?: string;
  }) {
    return this.prisma.task.create({
      data: {
        ...data,
        status: 'pending',
      },
    });
  }

  async findAll(filters?: { status?: string; createdBy?: string }) {
    return this.prisma.task.findMany({
      where: filters,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.task.findUnique({
      where: { id },
    });
  }

  async update(id: string, data: {
    status?: string;
    videoUrl?: string;
    errorMsg?: string;
    cost?: number;
    completedAt?: Date;
  }) {
    return this.prisma.task.update({
      where: { id },
      data,
    });
  }

  async findPending() {
    return this.prisma.task.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
  }
}
