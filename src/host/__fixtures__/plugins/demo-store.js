export default {
  activate(ctx) {
    ctx.services.register(ctx.service("demo-store:items"), { all: () => ["one", "two"] });
    ctx.events.subscribe(ctx.topic("config.changed"), () => {});
    ctx.provide(ctx.capability("settings"), {
      schema: () => ({ fields: [{ key: "limit", type: "number", label: "Limit" }] }),
      run: async (actionId) => ({ ok: actionId === "refresh", message: actionId }),
    });
  },
  deactivate() {},
};
