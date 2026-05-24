module.exports = (options, webpack) => ({
  ...options,
  externals: [
    (ctx, callback) => {
      const { request } = ctx;
      // Bundle workspace packages (@sto/*) instead of treating as external
      if (request && request.startsWith('@sto/')) return callback();
      // Use NestJS default externals behavior for everything else
      if (options.externals && Array.isArray(options.externals)) {
        for (const ext of options.externals) {
          if (typeof ext === 'function') {
            return ext(ctx, callback);
          }
        }
      }
      callback();
    },
  ],
});
