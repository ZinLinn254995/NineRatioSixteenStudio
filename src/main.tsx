import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {FirebaseErrorBoundary, FirebaseProvider} from './firebase';

createRoot(document.getElementById('root')!).render(
  <FirebaseErrorBoundary>
    <FirebaseProvider>
      <App />
    </FirebaseProvider>
  </FirebaseErrorBoundary>
);
