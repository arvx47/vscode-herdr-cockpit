// Entry point of the sidebar webview, bundled by scripts/build-webview.mjs into media/sidebar.js.
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('app')!).render(<App />);
