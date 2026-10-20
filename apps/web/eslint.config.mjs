import nextVitals from 'eslint-config-next/core-web-vitals';
import root from '../../eslint.config.mjs';

const config = [...root, ...nextVitals];

export default config;
