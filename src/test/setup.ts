import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

class MemoryStorage implements Storage {
  #values = new Map<string, string>();

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key: string) {
    return this.#values.get(String(key)) ?? null;
  }

  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.#values.delete(String(key));
  }

  setItem(key: string, value: string) {
    this.#values.set(String(key), String(value));
  }
}

// Node 24 reserves a global localStorage binding that can mask JSDOM's
// origin-backed implementation inside isolated test workers.
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
