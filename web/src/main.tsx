import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const contenedor = document.getElementById('root');
if (!contenedor) throw new Error('No se encontro #root en el documento.');

createRoot(contenedor).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
