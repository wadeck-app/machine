import { defineScenarios } from '@wadeck-app/app-core-sdk/scenarios';
import { SCENARIOS } from '../commons/scenarioList.js';

// The scenarios of the module (dev-only mocks of the Candidacies and Machines pages). BROWSER code: no Node API. The list itself is in src/commons/scenarioList.ts,
// where its tests can reach it (the module check forbids src/backend to import this folder).
export default defineScenarios(SCENARIOS);
