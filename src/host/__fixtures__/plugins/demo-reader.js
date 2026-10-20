export default {
  activate(ctx) {
    const store = ctx.services.get(ctx.service("demo-store:items"));
    ctx.provide(ctx.capability("commands"), {
      commands: () => [{ name: "demo", description: `demo over ${store ? store.all().length : 0} items` }],
    });
  },
  deactivate() {},
};
