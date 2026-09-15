import { roleLabel, userBlockReason, userScopeText } from "../labels.js";
import { SaveBar, useSection } from "../section.jsx";
import { useConfig } from "../store.jsx";
import { Button, Card, Field, Switch, inputCls } from "../ui.jsx";
import { Check, Trash2, Users } from "lucide-react";

/**
 * 一条用户人设的详情。
 *
 * 和角色的区别：角色是「AI 演谁」，这里是「和 AI 说话的人是谁」。
 * 两者一起拼进 system 段（见 server/src/imessage.js:buildMessages）。
 */
export function UserDetail({ user, onBack, onGoto }) {
  const { config, updateUser, removeUser, toggleUserRole } = useConfig();
  const roles = config.roles ?? [];
  const blocked = userBlockReason(config, user);

  return (
    <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
      <Card
        title="人设内容"
        desc={userScopeText(config, user)}
        actions={
          <Switch
            checked={user.enabled !== false}
            onChange={(v) => updateUser(user.id, { enabled: v })}
            label="启用这条人设"
          />
        }
      >
        <div className="grid grid-cols-1 gap-6">
          {blocked && (
            <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              {blocked}
            </p>
          )}

          <Field label="名字" hint="提示词里的 {{user}} 就是这个">
            <input
              className={inputCls}
              value={user.name ?? ""}
              onChange={(e) => updateUser(user.id, { name: e.target.value })}
              placeholder="例：小明"
            />
          </Field>

          <Field
            label="人设"
            hint="告诉模型你是谁、它该怎么对你说话。这段原样注入 <User> 标签 —— 想让模型知道你叫什么，正文里写一句 {{user}}"
          >
            <textarea
              className={`${inputCls} min-h-[140px] resize-y leading-relaxed`}
              value={user.description ?? ""}
              onChange={(e) => updateUser(user.id, { description: e.target.value })}
              placeholder="例：{{user}} 是个程序员，住在杭州，说话直接，不喜欢客套。和 {{char}} 是老朋友。"
            />
          </Field>

          <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
            这里也能用变量：{"{{char}}"} 是当前角色的名字，{"{{user}}"} 是上面那个名字。
            留空的变量会替换成「助手」/「用户」，不会把花括号原样发出去。
          </p>

          <Field label="生效范围">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {[
                { value: "global", label: "全局", desc: "所有角色都用这条，除非某个角色被单独指定了别的" },
                { value: "roles", label: "指定角色", desc: "只对下面勾选的角色生效，优先级高于全局" },
              ].map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => updateUser(user.id, { scope: s.value })}
                  className={`rounded-item border p-3.5 text-left transition-colors duration-150 ${
                    user.scope === s.value
                      ? "border-ink bg-sunken"
                      : "border-line hover:bg-sunken"
                  }`}
                >
                  <span className="flex items-center gap-2 text-ui text-ink">
                    <Users size={15} className={user.scope === s.value ? "text-ink" : "text-ink-faint"} />
                    {s.label}
                  </span>
                  <span className="mt-1 block text-meta leading-snug text-ink-faint">{s.desc}</span>
                </button>
              ))}
            </div>
          </Field>

          {user.scope === "roles" && (
            <Field label="对哪些角色生效">
              {roles.length === 0 ? (
                <p className="text-meta leading-relaxed text-ink-faint">
                  还没有角色。先去
                  <button
                    type="button"
                    onClick={() => onGoto?.("role")}
                    className="link-slide mx-1 text-ink"
                  >
                    「角色」面板
                  </button>
                  建一个。
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {roles.map((r) => {
                    const picked = (user.roleRefs ?? []).includes(r.id);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => toggleUserRole(user.id, r.id)}
                        className={`flex items-center gap-2 rounded-item border px-3.5 py-2.5 text-left text-ui transition-colors duration-150 ${
                          picked
                            ? "border-ink bg-sunken text-ink"
                            : "border-line text-ink-soft hover:bg-sunken"
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center border ${
                            picked ? "border-ink bg-ink text-paper-invert" : "border-line"
                          }`}
                        >
                          {picked && <Check size={11} />}
                        </span>
                        <span className="min-w-0 truncate">{roleLabel(r)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>
          )}

          <SaveBar />

          {/* 删除放在最后：破坏性操作不该和标题栏的开关挨着 */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-meta leading-relaxed text-ink-faint">
              删掉这条人设。绑给它的角色会退回全局那条（没有全局的就不带用户人设）。
            </p>
            <Button
              variant="ghost"
              onClick={() => {
                removeUser(user.id);
                onBack();
              }}
              className="text-warn hover:bg-warn/[0.08]"
            >
              <Trash2 size={14} /> 删除人设
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * 用户人设面板。
 *
 * 可以建多条：一条「我自己」全局用着，再给某个角色单独配一条不同的身份。
 * 真正发出去的时候按 resolveUser 的优先级取一条（绑定的 > 全局的）。
 */
export function UserPanel({ onGoto }) {
  const { config } = useConfig();
  const { itemId, pick } = useSection();
  const users = config.users ?? [];
  const open = users.find((u) => u.id === itemId) ?? null;

  if (!open) {
    return (
      <Card title="用户人设">
        {users.length ? (
          <div className="grid grid-cols-1 gap-6">
            <p className="max-w-[62ch] text-body text-ink-soft">
              左边挑一条人设。它决定角色人设里的 {"{{user}}"} 展开成谁。
            </p>
            {users.length > 1 && (
              <p className="max-w-[62ch] border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
                一个角色同时命中多条时，绑定了它的那条优先；都是全局的就取排在最前面那条。
              </p>
            )}
          </div>
        ) : (
          <div className="grid max-w-[62ch] grid-cols-1 gap-4">
            <p className="text-body text-ink-soft">
              还没有用户人设。不建也能用 —— 那模型就只知道自己是谁，不知道对面是谁。
            </p>
            <p className="text-meta leading-relaxed text-ink-faint">
              建一条之后，角色人设里就能写 {"{{user}}"} 了。
            </p>
          </div>
        )}
      </Card>
    );
  }

  return <UserDetail user={open} onBack={() => pick("")} onGoto={onGoto} />;
}
