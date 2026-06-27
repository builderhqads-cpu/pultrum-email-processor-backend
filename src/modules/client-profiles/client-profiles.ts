import type { ClientProfile } from './client-profile.types';
import { derixWesterkappelnProfile } from './profiles/derix.profile';

/**
 * The in-repo client profile registry. New mapped clients are added here as
 * data. This is the seam that later becomes a database table + admin UI so the
 * customer can manage profiles without a code deploy.
 */
export const CLIENT_PROFILES: ClientProfile[] = [derixWesterkappelnProfile];
