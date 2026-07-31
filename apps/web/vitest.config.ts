import react from '@vitejs/plugin-react';

import { compassVitestConfig } from '../../vitest.shared.js';

export default {
  ...compassVitestConfig('@compass/web'),
  plugins: [react()],
};
