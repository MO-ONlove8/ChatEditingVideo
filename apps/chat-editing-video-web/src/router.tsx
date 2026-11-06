import { createBrowserRouter } from 'react-router';
import { Layout } from './Layout';
import { ChatPage } from './pages/ChatPage';
import { JobsPage } from './pages/JobsPage';
import { ProjectsPage } from './pages/ProjectsPage';

export const routes = [
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <ProjectsPage /> },
      { path: 'chat', element: <ChatPage /> },
      { path: 'jobs', element: <JobsPage /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
