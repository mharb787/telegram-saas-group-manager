module.exports = {
  apps: [
    {
      name: 'gaza-real-estate-bot',
      cwd: '/opt/gaza-real-estate-bot',
      script: 'src/index.js',
      env: {
        NODE_ENV: 'production',
        APP_MODE: 'real_estate',
        DATABASE_PATH: './data/app.sqlite'
      }
    }
  ]
};
