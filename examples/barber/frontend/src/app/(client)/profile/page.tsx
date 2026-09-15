"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSimfinityClient } from "@/lib/simfinity";
import { RequireAuth } from "@/lib/requireAuth";
import { useAuth } from "@/lib/authContext";
import { useT } from "@/hooks/useT";
import { FormField, FormToggle } from "@/components/shared/form";
import { Button, Surface } from "@/components/shared/ui";
import { cn } from "@/lib/cn";
import { EYEBROW } from "@/theme/typography";

type UserData = {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
};

type NotificationPref = {
  id: string;
  labelKey: string;
  fallback: string;
  enabled: boolean;
};

const DEFAULT_NOTIFICATIONS: NotificationPref[] = [
  { id: "push", labelKey: "pushNotifications", fallback: "Notificaciones push", enabled: true },
  { id: "email", labelKey: "emailUpdates", fallback: "Actualizaciones por email", enabled: true },
  { id: "sms", labelKey: "smsReminders", fallback: "Recordatorios por SMS", enabled: false },
];

function ProfileContent() {
  const { user } = useAuth();
  const client = useSimfinityClient();
  const t = useT("profile");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [notifications, setNotifications] = useState<NotificationPref[]>(DEFAULT_NOTIFICATIONS);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;

    (async () => {
      try {
        const data = await client.getById("user", user.id, "id name email phone") as UserData | null;
        if (!cancelled) {
          if (data) {
            setName(data.name ?? user.name ?? "");
            setEmail(data.email ?? user.email ?? "");
            setPhone(data.phone ?? "");
          } else {
            setName(user.name ?? "");
            setEmail(user.email ?? "");
            setPhone("");
          }
        }
      } catch {
        if (!cancelled) {
          setName(user.name ?? "");
          setEmail(user.email ?? "");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, user]);

  const handleNotificationChange = useCallback(
    (id: string, value: boolean) => {
      setNotifications((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, enabled: value } : item,
        ),
      );
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!user?.id) return;
    setSaving(true);
    try {
      await client.update(
        "user",
        user.id,
        { name, phone },
        "id name email phone",
      );
      setToast({ message: t("saveSuccess", "Cambios guardados correctamente"), type: "success" });
    } catch {
      setToast({ message: t("saveError", "Error al guardar los cambios"), type: "error" });
    } finally {
      setSaving(false);
    }
  }, [client, user, name, phone, t]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto px-6 lg:px-12 py-8">
      {/* Avatar & name */}
      <div className="flex flex-col items-center mb-10">
        <div className="w-24 h-24 rounded-full bg-surface-container-high border-2 border-primary/20 flex items-center justify-center mb-4">
          <span className="material-symbols-outlined text-on-surface-variant text-4xl">
            person
          </span>
        </div>
        <h1 className="font-headline italic text-2xl text-on-surface">
          {name || "—"}
        </h1>
        <p className="text-sm text-on-surface-variant">{email}</p>
      </div>

      {/* Personal info */}
      <section className="mb-10">
        <h2 className={cn(EYEBROW, "font-label mb-4")}>
          {t("personalData", "Datos Personales")}
        </h2>
        <div className="space-y-4">
          <FormField
            label={t("name", "Nombre")}
            value={name}
            onChange={setName}
          />
          <FormField
            label={t("email", "Email")}
            value={email}
            onChange={() => {}}
            disabled
          />
          <FormField
            label={t("phone", "Teléfono")}
            value={phone}
            onChange={setPhone}
          />
        </div>
      </section>

      {/* Notifications */}
      <section className="mb-10">
        <h2 className={cn(EYEBROW, "font-label mb-4")}>
          {t("notificationPrefs", "Preferencias de Notificación")}
        </h2>
        <Surface tone="low" padding="md" radius="xl" className="space-y-4">
          {notifications.map((notif) => (
            <FormToggle
              key={notif.id}
              label={t(notif.labelKey, notif.fallback)}
              checked={notif.enabled}
              onChange={(val) => handleNotificationChange(notif.id, val)}
            />
          ))}
        </Surface>
      </section>

      {/* Security */}
      <section className="mb-10">
        <h2 className={cn(EYEBROW, "font-label mb-4")}>
          {t("security", "Seguridad")}
        </h2>
        <Link
          href="/auth/login"
          className="text-sm text-primary font-semibold hover:underline"
        >
          {t("changePassword", "Cambiar contraseña")}
        </Link>
      </section>

      {/* Save button */}
      <Button
        type="button"
        variant="gold"
        size="form"
        disabled={saving}
        onClick={handleSave}
        className="w-full py-4 text-on-primary"
      >
        {saving ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-5 h-5 border-2 border-on-primary border-t-transparent rounded-full animate-spin" />
            {t("saving", "Guardando...")}
          </span>
        ) : (
          t("saveChanges", "Guardar Cambios")
        )}
      </Button>

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-6 left-1/2 -translate-x-1/2 px-6 py-3 rounded-xl text-sm font-medium shadow-lg z-50 animate-[fadeIn_0.2s_ease]",
            toast.type === "success"
              ? "bg-emerald-500/90 text-white"
              : "bg-error/90 text-white",
          )}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

export default function ProfilePage() {
  return (
    <RequireAuth role="CLIENT">
      <ProfileContent />
    </RequireAuth>
  );
}
