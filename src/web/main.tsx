import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClientProvider } from './apiContext';
import { HostPage } from './HostPage';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ApiClientProvider>
        <HostPage />
      </ApiClientProvider>
    </StrictMode>,
  );
}
