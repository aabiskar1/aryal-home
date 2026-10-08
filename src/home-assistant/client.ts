import {env} from '../config/env.js';
import {createHomeAssistantStateReader} from './state-reader.js';

export const getHomeAssistantStates = createHomeAssistantStateReader(env.HA_URL, env.HA_TOKEN);
