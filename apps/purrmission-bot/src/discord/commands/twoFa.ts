/**
 * Handler for /2fa command (Backward compatibility entrypoint).
 * Re-exports modularized command object and handlers from ./twoFa/index.js
 */

export {
  twoFaCommand,
  handle2FACommand,
  handle2FAAutocomplete,
  handleTwoFaAutocomplete,
  handleAdd2FA,
  handleList2FA,
  handleGet2FA,
  handleUpdate2FA,
  data,
  execute,
  autocomplete,
} from './twoFa/index.js';
