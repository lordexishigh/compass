import noSystemClock from './rules/no-system-clock.js';
import noTimeLibraryImports from './rules/no-time-library-imports.js';
import noClockInstantiation from './rules/no-clock-instantiation.js';
import noAnalysisIo from './rules/no-analysis-io.js';

/**
 * Compass build gates. Registered in the root `eslint.config.js`; the guarded
 * path lists live there so there is one place to read them.
 */
const plugin = {
  meta: {
    name: '@compass/eslint-plugin',
    version: '0.1.0',
  },
  rules: {
    'no-system-clock': noSystemClock,
    'no-time-library-imports': noTimeLibraryImports,
    'no-clock-instantiation': noClockInstantiation,
    'no-analysis-io': noAnalysisIo,
  },
};

export default plugin;
export const rules = plugin.rules;
