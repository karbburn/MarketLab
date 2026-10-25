import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { StoreProvider } from './state/store';
import { LoadingGate } from './components/LoadingGate';
import { installDiagnostics } from './lib/diagnostics';

// Inert unless the page opted in before this module ran; see lib/diagnostics.ts.
installDiagnostics();

const container = document.getElementById('root');
if (!container) throw new Error('Root container is missing from index.html.');

createRoot(container).render(
  <StrictMode>
    <StoreProvider>
      <LoadingGate>
        <App />
      </LoadingGate>
    </StoreProvider>
  </StrictMode>,
);
