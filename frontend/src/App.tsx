import { useState, useEffect } from 'react';
import { PetOverlay } from './components/PetOverlay';
import type { PetConfig } from './types';

export function App() {
  const [petConfig, setPetConfig] = useState<PetConfig | null>(null);

  useEffect(() => {
    fetch('/api/pet')
      .then((r) => r.json())
      .then((data) => setPetConfig(data))
      .catch(() => setPetConfig(null));
  }, []);

  if (!petConfig || !petConfig.enabled) return null;

  return <PetOverlay pet={petConfig} />;
}
