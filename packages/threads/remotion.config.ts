import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);

Config.overrideWebpackConfiguration((currentConfiguration) => {
  return {
    ...currentConfiguration,
    resolve: {
      ...currentConfiguration.resolve,
      extensionAlias: {
        '.js': ['.ts', '.tsx', '.js'],
      },
    },
  };
});

