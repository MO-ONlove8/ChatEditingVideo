import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiRoutes, ProjectSchema, type CreateProjectInput } from '@cev/shared';
import { api } from '../lib/api';

const ProjectListSchema = ProjectSchema.array();

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => api(ProjectListSchema, ApiRoutes.projects),
  });
}

export function ProjectsPage() {
  const qc = useQueryClient();
  const projects = useProjects();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: (input: CreateProjectInput) =>
      api(ProjectSchema, ApiRoutes.projects, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate({ name });
  };

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">项目</h1>
      <form onSubmit={onSubmit} className="flex gap-2">
        <label htmlFor="project-name" className="sr-only">
          项目名称
        </label>
        <input
          id="project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新项目名称"
          maxLength={120}
          className="flex-1 rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={create.isPending || !name.trim()}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          创建
        </button>
      </form>
      {create.error && (
        <p role="alert" className="text-red-600">
          {create.error.message}
        </p>
      )}

      {projects.isPending && <p>加载中…</p>}
      {projects.error && (
        <p role="alert" className="text-red-600">
          无法加载项目：{projects.error.message}（服务端或数据库是否已启动？）
        </p>
      )}
      {projects.data?.length === 0 && <p className="text-neutral-500">还没有项目</p>}
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {projects.data?.map((p) => (
          <li key={p.id} className="py-2">
            <span className="font-medium">{p.name}</span>
            {p.description && <span className="ml-2 text-neutral-500">{p.description}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
