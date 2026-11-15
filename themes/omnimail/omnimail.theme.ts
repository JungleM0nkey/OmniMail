// The omnimail theme. `astryx experimental theme editor` wrote this file once and never changes it again.
// The checked settings live in omnimail.settings.json and the generated omnimail.settings.ts;
// change them with `astryx experimental theme editor set omnimail ...`. Add your own changes below: they win over the settings.
import {defineTheme} from '@astryxdesign/core/theme';
import {omnimailSettings} from './omnimail.settings';

export const omnimailTheme = defineTheme({
  extends: omnimailSettings,
  name: 'omnimail',
});
