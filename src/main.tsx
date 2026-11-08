import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@/app/App';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { installDebugHook } from '@/app/debug';
import '@/index.css';

installDebugHook();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
