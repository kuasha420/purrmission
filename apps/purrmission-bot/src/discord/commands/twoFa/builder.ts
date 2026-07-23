import { SlashCommandBuilder } from 'discord.js';

export const twoFaCommand = new SlashCommandBuilder()
  .setName('2fa')
  .setDescription('Manage 2FA accounts')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a new 2FA account')
      .addStringOption((option) =>
        option
          .setName('account')
          .setDescription('Account name (e.g. Google, AWS)')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription('Input mode')
          .setRequired(true)
          .addChoices(
            { name: 'URI (otpauth://...)', value: 'uri' },
            { name: 'Secret Key (Base32)', value: 'secret' },
            { name: 'QR Code Image', value: 'qr' }
          )
      )
      .addStringOption((option) =>
        option
          .setName('uri')
          .setDescription('otpauth:// URI (required if mode=uri)')
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName('secret')
          .setDescription('Base32 Secret (required if mode=secret)')
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName('issuer')
          .setDescription('Issuer name (optional, overrides URI/default)')
          .setRequired(false)
      )
      .addBooleanOption((option) =>
        option
          .setName('shared')
          .setDescription('Whether this code is shared with the team')
          .setRequired(false)
      )
      .addAttachmentOption((option) =>
        option
          .setName('qr')
          .setDescription('QR Code image (required if mode=qr)')
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('list')
      .setDescription('List your TOTP 2FA accounts')
      .addBooleanOption((option) =>
        option
          .setName('shared')
          .setDescription('Include shared accounts visible to you')
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('get')
      .setDescription('Get a TOTP code for one of your accounts')
      .addStringOption((option) =>
        option
          .setName('account')
          .setDescription('Account name')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addBooleanOption((option) =>
        option
          .setName('backup')
          .setDescription('Get the backup key instead of a TOTP code')
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('update')
      .setDescription('Update a TOTP account (e.g. add backup key)')
      .addStringOption((option) =>
        option
          .setName('account')
          .setDescription('Account name')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((option) =>
        option
          .setName('backup_key')
          .setDescription('Backup key / recovery code to store')
          .setRequired(true)
      )
  );
