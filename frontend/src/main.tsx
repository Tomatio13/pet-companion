import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './pet.css';

ReactDOM.createRoot(document.getElementById('pet-root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
