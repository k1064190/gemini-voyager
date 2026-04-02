// ABOUTME: Entry point for the local folder sync picker page
// Renders FolderPicker wrapped in LanguageProvider for i18n support
import { createRoot } from 'react-dom/client';

import '@assets/styles/tailwind.css';

import { LanguageProvider } from '../../contexts/LanguageContext';
import FolderPicker from './FolderPicker';

function init() {
  const rootContainer = document.querySelector('#__root');
  if (!rootContainer) throw new Error("Can't find Local Sync root element");
  const root = createRoot(rootContainer);
  root.render(
    <LanguageProvider>
      <FolderPicker />
    </LanguageProvider>,
  );
}

init();
