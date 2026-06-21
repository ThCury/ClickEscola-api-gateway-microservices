import React from 'react'
import { createRoot } from 'react-dom/client'
import ClickEscola from './App.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ClickEscola accent="blue" density="comfortable" livePulse={true} />
  </React.StrictMode>
)
