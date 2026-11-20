import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import mongoose from "mongoose";
import type { Server } from "node:http";

process.env.NODE_ENV = "test";
process.env.RESET_TOKEN_IN_RESPONSE = "1";
process.env.SUPER_ADMIN_EMAIL = "root@platform.test";
process.env.SUPER_ADMIN_PASSWORD = "SuperSecret123";
process.env.APP_ORIGIN = "http://localhost:5173";

const { buildV1, errorHandler } = await import("../src/v1/index.js");
const { bootstrapSuperAdmin } = await import("../src/v1/bootstrap.js");
const { AuditLog, PlatformUser, TRecipe, Restaurant } = await import("../src/v1/models.js");

let server: Server; let base = "";
const uri = (process.env.MONGODB_URI_TEST || "mongodb://127.0.0.1:27017") + "/ck_test_" + Date.now();

interface Opt { token?: string; body?: any; cookie?: string; headers?: Record<string, string>; }
async function api(method: string, path: string, o: Opt = {}) {
  const r = await fetch(base + "/api/v1" + path, {
    method, headers: { "content-type": "application/json", ...(o.token ? { authorization: "Bearer " + o.token } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers },
    body: o.body === undefined ? undefined : JSON.stringify(o.body)
  });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
  const sc = r.headers.getSetCookie?.().find((c) => c.startsWith("ck_rt="));
  return { status: r.status, json, cookie: sc ? sc.split(";")[0] : undefined };
}
const CSRF = { "x-ck-csrf": "1" };
const PW = "Password12345";
async function login(email: string, password = PW) {
  const r = await api("POST", "/auth/login", { body: { email, password } });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.json)}`);
  return { token: r.json.accessToken as string, cookie: r.cookie as string, me: r.json };
}

const S: any = {};  // общее состояние сценария

before(async () => {
  await mongoose.connect(uri);
  const app = express(); app.use(express.json()); app.use("/api/v1", buildV1(), errorHandler);
  await new Promise<void>((res) => { server = app.listen(0, "127.0.0.1", () => res()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  assert.equal(await bootstrapSuperAdmin(), "created");
  for (const m of mongoose.modelNames()) await mongoose.model(m).init().catch(() => {});
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); server.close(); });

describe("Bootstrap и вход", () => {
  it("bootstrap Super Admin идемпотентен", async () => {
    assert.equal(await bootstrapSuperAdmin(), "exists");
    assert.equal(await PlatformUser.countDocuments({ platformRole: "super_admin" }), 1);
  });
  it("пароль хранится как Argon2id, не в открытом виде", async () => {
    const u = await PlatformUser.findOne({ email: "root@platform.test" }).select("+passwordHash");
    assert.match(u.passwordHash, /^\$argon2id\$/);
  });
  it("неверный пароль → 401, одинаковый ответ для несуществующего email", async () => {
    const a = await api("POST", "/auth/login", { body: { email: "root@platform.test", password: "wrong-password" } });
    const b = await api("POST", "/auth/login", { body: { email: "nobody@x.test", password: "wrong-password" } });
    assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.json.error, b.json.error);
  });
  it("запрос без токена → 401", async () => assert.equal((await api("GET", "/recipes")).status, 401));
});

describe("1-2. Super Admin создаёт ресторан и владельца", () => {
  it("создание ресторанов A и B с новыми владельцами", async () => {
    S.sa = await login("root@platform.test", "SuperSecret123");
    for (const k of ["a", "b"]) {
      const r = await api("POST", "/platform/restaurants", { token: S.sa.token, body: { name: `Ресторан ${k.toUpperCase()}`, organization: `Org ${k}`, slug: `rest-${k}`, owner: { email: `owner-${k}@test.dev`, name: `Owner ${k}`, password: PW } } });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      S["rest" + k] = r.json.item.id;
    }
    const list = await api("GET", "/platform/restaurants", { token: S.sa.token });
    assert.equal(list.json.items.length, 2); assert.equal(list.json.items[0].membersCount, 1);
  });
  it("дубликат slug → 409; обычный пользователь не может в /platform", async () => {
    const d = await api("POST", "/platform/restaurants", { token: S.sa.token, body: { name: "X1", organization: "X1", slug: "rest-a", owner: { email: "o3@test.dev", name: "Owner 3", password: PW } } });
    assert.equal(d.status, 409);
  });
  it("Super Admin не является участником ресторанов: /recipes → 403", async () => {
    assert.equal((await api("GET", "/recipes", { token: S.sa.token })).status, 403);
  });
});

describe("3-7. Владелец: вход, сотрудники, роли, права", () => {
  it("3. владелец входит; меню строится из permissions", async () => {
    S.ownerA = await login("owner-a@test.dev"); S.ownerB = await login("owner-b@test.dev");
    assert.equal(S.ownerA.me.role.key, "owner"); assert.equal(S.ownerA.me.restaurant.id, S.resta);
    assert.ok(S.ownerA.me.permissions.recipes.includes("delete"));
  });
  it("данные ресторанов A и B", async () => {
    const mk = async (o: any, path: string, body: any) => { const r = await api("POST", path, { token: o.token, body }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.item; };
    S.catHot = await mk(S.ownerA, "/categories", { name: "Горячие блюда", zone: "hot" });
    S.catCold = await mk(S.ownerA, "/categories", { name: "Холодные закуски", zone: "cold" });
    const ing = { name: "Говядина", unit: "kg", gross: 0.2, net: 0.18, pricePerUnit: 90000 };
    S.hot1 = await mk(S.ownerA, "/recipes", { name: "Бефстроганов", categoryId: S.catHot.id, zone: "hot", portionCount: 1, ingredients: [ing], steps: [{ text: "Обжарить" }], status: "published" });
    S.cold1 = await mk(S.ownerA, "/recipes", { name: "Цезарь", categoryId: S.catCold.id, zone: "cold", ingredients: [ing], status: "published" });
    S.draft = await mk(S.ownerA, "/recipes", { name: "Черновик горячий", categoryId: S.catHot.id, zone: "hot", status: "draft" });
    S.catB = await mk(S.ownerB, "/categories", { name: "Блюда B", zone: "hot" });
    S.recB = await mk(S.ownerB, "/recipes", { name: "Секретный рецепт B", categoryId: S.catB.id, status: "published", ingredients: [ing] });
  });
  it("5. владелец создаёт пользовательскую роль «Повар горячего цеха»", async () => {
    const r = await api("POST", "/restaurant/roles", { token: S.ownerA.token, body: { name: "Повар горячего цеха", permissions: { recipes: ["view"], categories: ["view"], ingredients: ["view"] }, scope: "assigned", denyCost: true, features: ["tts", "cooking_mode"] } });
    assert.equal(r.status, 201, JSON.stringify(r.json)); S.roleHot = r.json.item;
  });
  it("4+6. владелец создаёт сотрудника и выдаёт права на категорию", async () => {
    const r = await api("POST", "/restaurant/members", { token: S.ownerA.token, body: { email: "cook@test.dev", name: "Повар Иван", password: PW, roleId: S.roleHot.id, assigned: { categoryIds: [S.catHot.id] } } });
    assert.equal(r.status, 201, JSON.stringify(r.json)); S.cookMember = r.json.item;
    S.cook = await login("cook@test.dev");
  });
  it("8. повар видит только разрешённые карты (опубликованные, своя категория), без себестоимости", async () => {
    const l = await api("GET", "/recipes?full=1", { token: S.cook.token });
    assert.equal(l.status, 200); assert.deepEqual(l.json.items.map((x: any) => x.name), ["Бефстроганов"]);
    assert.equal(l.json.items[0].cost, undefined); assert.equal(l.json.items[0].ingredients[0].pricePerUnit, undefined);
    assert.equal((await api("GET", `/recipes/${S.cold1.id}`, { token: S.cook.token })).status, 404);
    assert.equal((await api("GET", `/recipes/${S.draft.id}`, { token: S.cook.token })).status, 404);
    assert.equal((await api("GET", "/calculations", { token: S.cook.token })).status, 403);
  });
  it("9. повар не может редактировать/удалять/публиковать/создавать", async () => {
    const h = S.hot1.id;
    assert.equal((await api("PATCH", `/recipes/${h}`, { token: S.cook.token, body: { name: "Взлом" } })).status, 403);
    assert.equal((await api("DELETE", `/recipes/${h}`, { token: S.cook.token })).status, 403);
    assert.equal((await api("POST", `/recipes/${h}/publish`, { token: S.cook.token })).status, 403);
    assert.equal((await api("POST", "/recipes", { token: S.cook.token, body: { name: "Новый" } })).status, 403);
    assert.equal((await api("GET", "/restaurant/members", { token: S.cook.token })).status, 403);
    assert.equal((await api("GET", "/audit-logs", { token: S.cook.token })).status, 403);
  });
  it("7. владелец выдаёт доступ к конкретной карте (Recipe-based)", async () => {
    const r = await api("PATCH", `/restaurant/members/${S.cookMember.id}`, { token: S.ownerA.token, body: { assigned: { categoryIds: [S.catHot.id], recipeIds: [S.cold1.id] } } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const l = await api("GET", "/recipes", { token: S.cook.token });
    assert.deepEqual(l.json.items.map((x: any) => x.name).sort(), ["Бефстроганов", "Цезарь"]);
    assert.equal((await api("GET", `/recipes/${S.cold1.id}`, { token: S.cook.token })).status, 200);
  });
  it("доступ по цеху (workzone)", async () => {
    const r = await api("PATCH", `/restaurant/members/${S.cookMember.id}`, { token: S.ownerA.token, body: { assigned: { zones: ["cold"] } } });
    assert.equal(r.status, 200);
    const l = await api("GET", "/recipes", { token: S.cook.token }); assert.deepEqual(l.json.items.map((x: any) => x.name), ["Цезарь"]);
  });
  it("10. повар с полными правами управляет картами", async () => {
    const role = await api("POST", "/restaurant/roles", { token: S.ownerA.token, body: { name: "Повар-админ", permissions: { recipes: ["view", "create", "edit", "delete", "publish", "import"], imports: ["view", "import"], categories: ["view"], ingredients: ["view"] }, scope: "all", denyCost: false, denyPurchasePriceEdit: false } });
    assert.equal(role.status, 201, JSON.stringify(role.json));
    const m = await api("POST", "/restaurant/members", { token: S.ownerA.token, body: { email: "cook2@test.dev", name: "Повар Пётр", password: PW, roleId: role.json.item.id } });
    assert.equal(m.status, 201); const c = await login("cook2@test.dev");
    const cr = await api("POST", "/recipes", { token: c.token, body: { name: "Борщ", categoryId: S.catHot.id, zone: "hot", ingredients: [{ name: "Свёкла", unit: "kg", gross: 0.3, pricePerUnit: 8000 }] } });
    assert.equal(cr.status, 201, JSON.stringify(cr.json)); const id = cr.json.item.id;
    assert.equal((await api("PATCH", `/recipes/${id}`, { token: c.token, body: { description: "Классический" } })).status, 200);
    assert.equal((await api("POST", `/recipes/${id}/publish`, { token: c.token })).json.item.status, "published");
    const imp = await api("POST", "/imports", { token: c.token, body: { recipes: [{ name: "Импорт 1", categoryId: S.catHot.id }, { name: "Импорт 2" }] } });
    assert.equal(imp.status, 201); assert.equal(imp.json.created, 2);
    assert.equal((await api("DELETE", `/recipes/${id}`, { token: c.token })).status, 200);
    assert.equal((await api("POST", "/restaurant/roles", { token: c.token, body: { name: "x1", permissions: {} } })).status, 403);
  });
  it("запрет редактировать закупочные цены: сервер подставляет сохранённые", async () => {
    const role = await api("POST", "/restaurant/roles", { token: S.ownerA.token, body: { name: "Су-шеф без цен", permissions: { recipes: ["view", "edit"] }, scope: "all", denyCost: false, denyPurchasePriceEdit: true } });
    const m = await api("POST", "/restaurant/members", { token: S.ownerA.token, body: { email: "sous@test.dev", name: "Су-шеф", password: PW, roleId: role.json.item.id } });
    assert.equal(m.status, 201); const c = await login("sous@test.dev");
    const up = await api("PATCH", `/recipes/${S.hot1.id}`, { token: c.token, body: { ingredients: [{ name: "Говядина", unit: "kg", gross: 0.2, net: 0.18, pricePerUnit: 1 }] } });
    assert.equal(up.status, 200, JSON.stringify(up.json)); assert.equal(up.json.item.ingredients[0].pricePerUnit, 90000);
  });
});

describe("11-12. Изоляция ресторанов", () => {
  it("11. A не видит данные B", async () => {
    const l = await api("GET", "/recipes?full=1&limit=500", { token: S.ownerA.token });
    assert.ok(l.json.items.every((x: any) => x.name !== "Секретный рецепт B"));
    assert.equal((await api("GET", `/recipes/${S.recB.id}`, { token: S.ownerA.token })).status, 404);
    assert.equal((await api("PATCH", `/recipes/${S.recB.id}`, { token: S.ownerA.token, body: { name: "Хак" } })).status, 404);
    assert.equal((await api("DELETE", `/recipes/${S.recB.id}`, { token: S.ownerA.token })).status, 404);
    assert.equal((await api("POST", `/recipes/${S.recB.id}/duplicate`, { token: S.ownerA.token })).status, 404);
    assert.equal((await api("GET", `/calculations/${S.recB.id}`, { token: S.ownerA.token })).status, 404);
    const b = await TRecipe.findOne({ restaurantId: S.restb, _id: S.recB.id }).lean<any>(); assert.equal(b.name, "Секретный рецепт B");
    assert.equal((await api("GET", "/categories", { token: S.ownerA.token })).json.items.some((c: any) => c.id === S.catB.id), false);
  });
  it("12. подмена restaurantId в теле, query и заголовках ничего не даёт", async () => {
    const r = await api("POST", "/recipes", { token: S.ownerA.token, headers: { "x-restaurant-id": S.restb }, body: { name: "Подмена", restaurantId: S.restb, status: "draft" } });
    assert.equal(r.status, 201);
    const inA = await TRecipe.findOne({ restaurantId: S.resta, name: "Подмена" }); assert.ok(inA);
    assert.equal(await TRecipe.countDocuments({ restaurantId: S.restb, name: "Подмена" }), 0);
    const l = await api("GET", `/recipes?restaurantId=${S.restb}&limit=500`, { token: S.ownerB.token, headers: { "x-restaurant-id": S.resta } });
    assert.ok(l.json.items.every((x: any) => x.name !== "Подмена" && x.name !== "Бефстроганов"));
    assert.equal((await api("POST", "/auth/switch-restaurant", { token: S.ownerA.token, body: { restaurantId: S.restb } })).status, 403);
    // назначение чужой категории/карточки сотруднику
    const bad = await api("PATCH", `/restaurant/members/${S.cookMember.id}`, { token: S.ownerA.token, body: { assigned: { categoryIds: [S.catB.id] } } });
    assert.equal(bad.status, 400);
    const bad2 = await api("POST", "/recipes", { token: S.ownerA.token, body: { name: "Чужая категория", categoryId: S.catB.id } });
    assert.equal(bad2.status, 400);
    // сотрудник A по id другого ресторана
    assert.equal((await api("PATCH", `/restaurant/members/${S.ownerB.me.user.id}`, { token: S.ownerA.token, body: { name: "xx" } })).status, 404);
  });
  it("tenantGuard: запрос без restaurantId отклоняется на уровне модели", async () => {
    await assert.rejects(() => TRecipe.find({}).exec(), /tenantGuard/);
    await assert.rejects(() => TRecipe.deleteMany({}).exec(), /tenantGuard/);
  });
  it("роли и сотрудники изолированы", async () => {
    const mb = await api("GET", "/restaurant/members", { token: S.ownerB.token });
    assert.equal(mb.json.items.length, 1);
    const rb = await api("GET", "/restaurant/roles", { token: S.ownerB.token });
    assert.ok(rb.json.items.every((x: any) => !["Повар горячего цеха", "Повар-админ"].includes(x.name)));
  });
});

describe("Защита от privilege escalation", () => {
  it("роль с ограниченными правами не может выдать лишнее", async () => {
    const lead = await api("POST", "/restaurant/roles", { token: S.ownerA.token, body: { name: "Помощник админа", permissions: { recipes: ["view"], categories: ["view"], ingredients: ["view"], roles: ["view", "create", "edit"], members: ["view", "create", "edit"] }, scope: "assigned", denyCost: true, features: ["tts", "cooking_mode"] } });
    assert.equal(lead.status, 201, JSON.stringify(lead.json));
    const mk = await api("POST", "/restaurant/members", { token: S.ownerA.token, body: { email: "lead@test.dev", name: "Помощник", password: PW, roleId: lead.json.item.id, assigned: { categoryIds: [S.catHot.id] } } });
    assert.equal(mk.status, 201); const L = await login("lead@test.dev");
    const ownerRole = (await api("GET", "/restaurant/roles", { token: S.ownerA.token })).json.items.find((x: any) => x.key === "owner");
    const mgrRole = (await api("GET", "/restaurant/roles", { token: S.ownerA.token })).json.items.find((x: any) => x.key === "manager");
    assert.equal((await api("POST", "/restaurant/roles", { token: L.token, body: { name: "Супер", permissions: { recipes: ["view", "delete"] }, scope: "assigned" } })).status, 403);
    assert.equal((await api("POST", "/restaurant/roles", { token: L.token, body: { name: "Всё видит", permissions: { recipes: ["view"] }, scope: "all" } })).status, 403);
    assert.equal((await api("POST", "/restaurant/roles", { token: L.token, body: { name: "Видит цены", permissions: { recipes: ["view"] }, denyCost: false } })).status, 403);
    assert.equal((await api("POST", "/restaurant/members", { token: L.token, body: { email: "x1@test.dev", name: "Икс Один", password: PW, roleId: ownerRole.id } })).status, 403);
    assert.equal((await api("POST", "/restaurant/members", { token: L.token, body: { email: "x2@test.dev", name: "Икс Два", password: PW, roleId: mgrRole.id } })).status, 403);
    assert.equal((await api("PATCH", `/restaurant/members/${S.ownerA.me.user.id}`, { token: L.token, body: { name: "Хак" } })).status, 404); // userId ≠ membershipId
    const ownerMember = (await api("GET", "/restaurant/members", { token: L.token })).json.items.find((m: any) => m.roleKey === "owner");
    assert.equal((await api("PATCH", `/restaurant/members/${ownerMember.id}`, { token: L.token, body: { name: "Хак" } })).status, 403);
    assert.equal((await api("POST", `/restaurant/members/${ownerMember.id}/block`, { token: L.token })).status, 403);
    // самому себе роль не поменять
    const me = (await api("GET", "/restaurant/members", { token: L.token })).json.items.find((m: any) => m.email === "lead@test.dev");
    assert.equal((await api("PATCH", `/restaurant/members/${me.id}`, { token: L.token, body: { roleId: mgrRole.id } })).status, 403);
    // назначить чужую (не назначенную ему) категорию нельзя
    assert.equal((await api("POST", "/restaurant/members", { token: L.token, body: { email: "x3@test.dev", name: "Икс Три", password: PW, roleId: S.roleHot.id, assigned: { categoryIds: [S.catCold.id] } } })).status, 400);
    // системные роли неизменяемы
    assert.equal((await api("PATCH", `/restaurant/roles/${mgrRole.id}`, { token: S.ownerA.token, body: { name: "Новое" } })).status, 400);
  });
});

describe("13. Сессии, токены, блокировки", () => {
  it("13. отозванная сессия больше не работает (мгновенно)", async () => {
    const c = await login("cook@test.dev");
    assert.equal((await api("GET", "/recipes", { token: c.token })).status, 200);
    const r = await api("POST", `/restaurant/members/${S.cookMember.id}/revoke-sessions`, { token: S.ownerA.token });
    assert.equal(r.status, 200); assert.ok(r.json.revoked >= 1);
    assert.equal((await api("GET", "/recipes", { token: c.token })).status, 401);
    assert.equal((await api("POST", "/auth/refresh", { cookie: c.cookie, headers: CSRF })).status, 401);
  });
  it("refresh: ротация, reuse detection отзывает всю семью", async () => {
    const c = await login("cook@test.dev");
    const r1 = await api("POST", "/auth/refresh", { cookie: c.cookie, headers: CSRF });
    assert.equal(r1.status, 200); assert.ok(r1.cookie && r1.cookie !== c.cookie);
    await new Promise((r) => setTimeout(r, 10_500)); // выйти из окна «гонки вкладок»
    const reuse = await api("POST", "/auth/refresh", { cookie: c.cookie, headers: CSRF }); // старый токен
    assert.equal(reuse.status, 401);
    assert.equal((await api("POST", "/auth/refresh", { cookie: r1.cookie, headers: CSRF })).status, 401, "новый токен тоже отозван");
    assert.equal((await api("GET", "/auth/me", { token: r1.json.accessToken })).status, 401);
    const log = await AuditLog.findOne({ action: "auth.refresh_reuse_detected" }); assert.ok(log);
  });
  it("CSRF: refresh без заголовка или с чужим Origin → 403", async () => {
    const c = await login("cook@test.dev");
    assert.equal((await api("POST", "/auth/refresh", { cookie: c.cookie })).status, 403);
    assert.equal((await api("POST", "/auth/refresh", { cookie: c.cookie, headers: { ...CSRF, origin: "https://evil.example" } })).status, 403);
    assert.equal((await api("POST", "/auth/refresh", { cookie: c.cookie, headers: { ...CSRF, origin: "http://localhost:5173" } })).status, 200);
  });
  it("logout отзывает refresh-токен", async () => {
    const c = await login("cook@test.dev");
    assert.equal((await api("POST", "/auth/logout", { cookie: c.cookie, headers: CSRF })).status, 200);
    assert.equal((await api("GET", "/auth/me", { token: c.token })).status, 401);
    assert.equal((await api("POST", "/auth/refresh", { cookie: c.cookie, headers: CSRF })).status, 401);
  });
  it("смена пароля отзывает старые сессии", async () => {
    const a = await login("cook@test.dev"); const b = await login("cook@test.dev");
    const ch = await api("POST", "/auth/password/change", { token: a.token, body: { currentPassword: PW, newPassword: "NewPassword777" } });
    assert.equal(ch.status, 200); assert.equal((await api("GET", "/auth/me", { token: b.token })).status, 401);
    assert.equal((await api("GET", "/auth/me", { token: a.token })).status, 401);
    assert.equal((await api("GET", "/auth/me", { token: ch.json.accessToken })).status, 200);
    S.cookPw = "NewPassword777";
  });
  it("восстановление пароля: одинаковый ответ, одноразовый токен, отзыв сессий", async () => {
    const unknown = await api("POST", "/auth/password/forgot", { body: { email: "ghost@test.dev" } });
    assert.equal(unknown.status, 200); assert.equal(unknown.json.devToken, undefined);
    const f = await api("POST", "/auth/password/forgot", { body: { email: "cook@test.dev" } });
    assert.ok(f.json.devToken);
    const old = await login("cook@test.dev", S.cookPw);
    assert.equal((await api("POST", "/auth/password/reset", { body: { token: f.json.devToken, newPassword: "short" } })).status, 400);
    assert.equal((await api("POST", "/auth/password/reset", { body: { token: f.json.devToken, newPassword: "Recovered12345" } })).status, 200);
    assert.equal((await api("POST", "/auth/password/reset", { body: { token: f.json.devToken, newPassword: "Another12345x" } })).status, 400);
    assert.equal((await api("GET", "/auth/me", { token: old.token })).status, 401);
    S.cookPw = "Recovered12345"; await login("cook@test.dev", S.cookPw);
  });
  it("блокировка сотрудника владельцем действует немедленно", async () => {
    const c = await login("cook@test.dev", S.cookPw);
    assert.equal((await api("POST", `/restaurant/members/${S.cookMember.id}/block`, { token: S.ownerA.token })).status, 200);
    assert.equal((await api("GET", "/recipes", { token: c.token })).status, 403);
    assert.equal((await api("POST", `/restaurant/members/${S.cookMember.id}/unblock`, { token: S.ownerA.token })).status, 200);
    assert.equal((await api("GET", "/recipes", { token: c.token })).status, 200);
  });
  it("блокировка аккаунта Super Admin'ом: доступ закрыт сразу, вход невозможен", async () => {
    const c = await login("cook@test.dev", S.cookPw);
    assert.equal((await api("POST", `/platform/users/${S.cookMember.userId}/status`, { token: S.sa.token, body: { status: "blocked" } })).status, 200);
    assert.equal((await api("GET", "/recipes", { token: c.token })).status, 401);
    assert.equal((await api("POST", "/auth/login", { body: { email: "cook@test.dev", password: S.cookPw } })).status, 403);
    await api("POST", `/platform/users/${S.cookMember.userId}/status`, { token: S.sa.token, body: { status: "active" } });
  });
  it("ограничение доступа по времени", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    await api("PATCH", `/restaurant/members/${S.cookMember.id}`, { token: S.ownerA.token, body: { accessUntil: past } });
    const c = await login("cook@test.dev", S.cookPw);
    const r = await api("GET", "/recipes", { token: c.token }); assert.equal(r.status, 403); assert.equal(r.json.code, "access_window");
    await api("PATCH", `/restaurant/members/${S.cookMember.id}`, { token: S.ownerA.token, body: { accessUntil: null } });
    assert.equal((await api("GET", "/recipes", { token: c.token })).status, 200);
  });
  it("блокировка входа после серии неудачных попыток", async () => {
    for (let i = 0; i < 5; i++) await api("POST", "/auth/login", { body: { email: "owner-b@test.dev", password: "bad-password-" + i } });
    const r = await api("POST", "/auth/login", { body: { email: "owner-b@test.dev", password: PW } });
    assert.equal(r.status, 429);
    await PlatformUser.updateOne({ email: "owner-b@test.dev" }, { lockUntil: null, failedLogins: 0 });
  });
});

describe("14. Заблокированный ресторан", () => {
  it("suspended ресторан не обслуживает запросы; после активации — работает", async () => {
    const o = await login("owner-a@test.dev");
    assert.equal((await api("POST", `/platform/restaurants/${S.resta}/status`, { token: S.sa.token, body: { status: "suspended" } })).status, 200);
    const r = await api("GET", "/recipes", { token: o.token }); assert.equal(r.status, 403); assert.equal(r.json.code, "restaurant_suspended");
    assert.equal((await api("GET", "/restaurant/members", { token: o.token })).status, 403);
    const me = await api("GET", "/auth/me", { token: o.token }); assert.equal(me.status, 200); assert.equal(me.json.tenantError.code, "restaurant_suspended");
    const c = await login("cook@test.dev", S.cookPw); assert.equal((await api("GET", "/recipes", { token: c.token })).status, 403);
    assert.equal((await api("GET", "/recipes", { token: S.ownerB.token })).status, 200, "ресторан B не затронут");
    await api("POST", `/platform/restaurants/${S.resta}/status`, { token: S.sa.token, body: { status: "active" } });
    assert.equal((await api("GET", "/recipes", { token: o.token })).status, 200);
  });
  it("архивирование ресторана", async () => {
    const x = await api("POST", "/platform/restaurants", { token: S.sa.token, body: { name: "Временный", organization: "Tmp", slug: "tmp-rest", owner: { email: "tmp@test.dev", name: "Tmp Owner", password: PW } } });
    const o = await login("tmp@test.dev");
    assert.equal((await api("DELETE", `/platform/restaurants/${x.json.item.id}`, { token: S.sa.token })).json.item.status, "archived");
    assert.equal((await api("GET", "/recipes", { token: o.token })).status, 403);
  });
  it("смена владельца: прежний понижается, новый получает owner", async () => {
    const mgr = (await api("GET", "/restaurant/members", { token: S.ownerB.token })).json.items[0];
    const nu = await api("POST", "/platform/users", { token: S.sa.token, body: { email: "newowner@test.dev", name: "Новый Владелец", password: PW } });
    assert.equal((await api("POST", `/platform/restaurants/${S.restb}/owner`, { token: S.sa.token, body: { ownerId: nu.json.item.id } })).status, 200);
    const n = await login("newowner@test.dev"); assert.equal(n.me.role.key, "owner"); S.newOwner = n;
    const old = await api("GET", "/auth/me", { token: S.ownerB.token }); assert.equal(old.json.role.key, "manager"); assert.equal(mgr.roleKey, "owner");
  });
});

describe("15. Audit Log", () => {
  it("изменения прав и роли фиксируются со старым/новым значением", async () => {
    const logs = await api("GET", "/audit-logs?limit=500", { token: S.ownerA.token });
    assert.equal(logs.status, 200);
    const acts = logs.json.items.map((x: any) => x.action);
    for (const a of ["role.created", "member.created", "member.permissions_changed", "recipe.created", "recipe.deleted", "auth.login", "member.blocked", "member.sessions_revoked", "restaurant.status_changed"]) assert.ok(acts.includes(a), "нет записи " + a);
    const ch = logs.json.items.find((x: any) => x.action === "member.permissions_changed");
    assert.ok(ch.before && ch.after && ch.actorEmail === "owner-a@test.dev");
  });
  it("изменение себестоимости логируется; пароли не попадают в журнал", async () => {
    await api("PATCH", `/recipes/${S.hot1.id}`, { token: S.ownerA.token, body: { ingredients: [{ name: "Говядина", unit: "kg", gross: 0.2, pricePerUnit: 100000 }] } });
    const logs = (await api("GET", "/audit-logs?action=recipe.cost_changed", { token: S.ownerA.token })).json.items;
    assert.ok(logs.length >= 1); assert.ok(logs[0].before.total !== logs[0].after.total);
    const raw = JSON.stringify(await AuditLog.find({}).lean()); assert.ok(!/argon2id|Password12345|NewPassword777/.test(raw));
  });
  it("журнал изолирован по ресторанам и неизменяем", async () => {
    const b = (await api("GET", "/audit-logs?limit=500", { token: S.newOwner.token })).json.items;
    assert.ok(b.every((x: any) => x.restaurantId === S.restb));
    await assert.rejects(() => AuditLog.updateOne({}, { action: "x" }).exec(), /append-only/);
    await assert.rejects(() => AuditLog.deleteMany({}).exec(), /append-only/);
  });
  it("Super Admin видит системный журнал и каждое support-обращение логируется", async () => {
    const v = await api("GET", `/platform/restaurants/${S.resta}/support/recipes`, { token: S.sa.token }); assert.equal(v.status, 200);
    const g = await api("GET", "/platform/audit-logs?action=support", { token: S.sa.token }); assert.ok(g.json.items.length >= 1);
    assert.equal((await api("GET", "/platform/audit-logs", { token: S.ownerA.token })).status, 403);
  });
});

describe("Прочее", () => {
  it("калькуляции и dashboard владельца", async () => {
    const c = await api("GET", "/calculations", { token: S.ownerA.token }); assert.equal(c.status, 200); assert.ok(c.json.summary.count >= 2);
    const d = await api("GET", "/dashboard", { token: S.ownerA.token }); assert.equal(d.status, 200); assert.ok(d.json.recipes.total >= 3); assert.ok(d.json.members >= 2);
  });
  it("валидация: мусор и неверные id → 400", async () => {
    assert.equal((await api("POST", "/recipes", { token: S.ownerA.token, body: { name: "" } })).status, 400);
    assert.equal((await api("GET", "/recipes/not-an-id", { token: S.ownerA.token })).status, 400);
    assert.equal((await api("PATCH", `/recipes/${S.hot1.id}`, { token: S.ownerA.token, body: { status: "hacked" } })).status, 400);
  });
  it("сессии пользователя: список и отзыв", async () => {
    const o = await login("owner-a@test.dev"); const l = await api("GET", "/sessions", { token: o.token });
    assert.ok(l.json.items.some((s: any) => s.current));
    const other = l.json.items.find((s: any) => !s.current);
    assert.equal((await api("DELETE", `/sessions/${other.id}`, { token: o.token })).status, 200);
    assert.equal((await api("POST", "/auth/logout-all", { token: o.token })).status, 200);
    assert.equal((await api("GET", "/auth/me", { token: o.token })).status, 401);
  });
});
