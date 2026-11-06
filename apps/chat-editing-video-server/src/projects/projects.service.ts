import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { CreateProjectInput, Project, UpdateProjectInput } from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import { projects, type ProjectRow } from '../database/schema.js';

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class ProjectsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(): Promise<Project[]> {
    const rows = await this.db.select().from(projects).orderBy(desc(projects.createdAt)).limit(200);
    return rows.map(toProject);
  }

  async get(id: string): Promise<Project> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, id));
    if (!row) throw new NotFoundException(`Project ${id} not found`);
    return toProject(row);
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const [row] = await this.db
      .insert(projects)
      .values({ name: input.name, description: input.description ?? null })
      .returning();
    return toProject(row!);
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    const [row] = await this.db.update(projects).set(input).where(eq(projects.id, id)).returning();
    if (!row) throw new NotFoundException(`Project ${id} not found`);
    return toProject(row);
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.db
      .delete(projects)
      .where(eq(projects.id, id))
      .returning({ id: projects.id });
    if (deleted.length === 0) throw new NotFoundException(`Project ${id} not found`);
  }
}
