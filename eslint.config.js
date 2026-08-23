import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTypeScript,
  {
    ignores: [
      '.next/**',
      '.venv/**',
      'coverage/**',
      'dist/**',
      'out/**',
      'public/sw.js',
      'src/generated/**',
    ],
  },
];

export default config;
