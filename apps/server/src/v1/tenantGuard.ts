
/**
 * Страховка изоляции: любой запрос к ресторанной коллекции обязан содержать restaurantId.
 * Забытый фильтр → исключение, а не утечка чужих данных. Явный обход: query.setOptions({ skipTenant: true })
 * (используется только платформенным кодом Super Admin и входом пользователя).
 */
export function tenantGuard(schema: any, opts: { allowUserScope?: boolean } = {}) {
  const ops = ["find", "findOne", "countDocuments", "updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "replaceOne", "distinct"] as const;
  for (const op of ops) {
    schema.pre(op as any, function (this: any, next: any) {
      if (this.getOptions?.().skipTenant) return next();
      const f = this.getFilter?.() ?? {};
      const ok = f.restaurantId !== undefined || (opts.allowUserScope && f.userId !== undefined);
      if (!ok) return next(new Error(`tenantGuard: запрос ${op} без restaurantId отклонён`));
      next();
    });
  }
  schema.pre("aggregate", function (this: any, next: any) {
    const first = this.pipeline()[0]?.$match;
    if (this.options?.skipTenant || first?.restaurantId !== undefined) return next();
    next(new Error("tenantGuard: aggregate без $match по restaurantId отклонён"));
  });
}
