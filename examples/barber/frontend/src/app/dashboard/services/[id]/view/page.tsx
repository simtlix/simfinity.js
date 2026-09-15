"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { useSimfinityClient } from "@/lib/simfinity";
import {
  PageHeader,
  FormField,
  FormTextarea,
  FormSelect,
  FormDurationSelect,
  FormCurrencyInput,
  FormToggle,
  FormImageUpload,
  FormSection,
  FormLayout,
  FormSidePanel,
  ConfirmModal,
} from "@/components/shared";
import { useT } from "@/hooks/useT";

type Category = { id: string; name: string };

type ServiceData = {
  id: string;
  name: string;
  description?: string;
  price?: number;
  durationMinutes?: number;
  isActive?: boolean;
  category?: Category;
  imageUrl?: string;
};

const SERVICE_FIELDS = "id name description price durationMinutes isActive category { id name } imageUrl";

export default function ViewServicePage() {
  const client = useSimfinityClient();
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const t = useT("dashboard");

  const [service, setService] = useState<ServiceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const result = await client.getById("service", id, SERVICE_FIELDS);
        if (result) setService(result as unknown as ServiceData);
      } catch {
        /* keep null */
      } finally {
        setLoading(false);
      }
    })();
  }, [client, id]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await client.delete("service", id);
      router.push("/dashboard/services");
    } catch {
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <span className="material-symbols-outlined text-primary text-3xl animate-spin">
          progress_activity
        </span>
      </div>
    );
  }

  if (!service) {
    return (
      <div className="text-center py-20">
        <span className="material-symbols-outlined text-on-surface-variant/40 text-5xl mb-4">
          search_off
        </span>
        <p className="text-on-surface-variant">{t("services.notFound", "Servicio no encontrado")}</p>
      </div>
    );
  }

  const categoryOptions = service.category
    ? [{ value: service.category.id, label: service.category.name }]
    : [];

  return (
    <>
      <PageHeader
        title={service.name}
        breadcrumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: t("services.title", "Servicios"), href: "/dashboard/services" },
          { label: t("common.view", "Ver") },
        ]}
        actions={
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push(`/dashboard/services/${id}/edit`)}
              className="flex items-center gap-2 border border-primary/40 text-primary px-5 py-2.5 rounded-lg hover:bg-primary/5 transition-all text-xs uppercase tracking-widest font-semibold"
            >
              <span className="material-symbols-outlined text-sm">edit</span>
              {t("common.edit", "Editar")}
            </button>
            <button
              onClick={() => setDeleteOpen(true)}
              className="flex items-center gap-2 border border-error/40 text-error px-5 py-2.5 rounded-lg hover:bg-error/5 transition-all text-xs uppercase tracking-widest font-semibold"
            >
              <span className="material-symbols-outlined text-sm">delete</span>
              {t("common.delete", "Eliminar")}
            </button>
          </div>
        }
      />

      <FormLayout
        sidebar={
          <FormSidePanel>
            <FormImageUpload
              label={t("services.image", "Imagen de Portada")}
              value={service.imageUrl ?? ""}
              onChange={() => {}}
              variant="wide"
              disabled
            />
          </FormSidePanel>
        }
      >
        <div className="space-y-8">
          <FormSection title={t("services.dataSection", "Datos del Servicio")} icon="content_paste">
            <FormField
              label={t("services.name", "Nombre del Servicio")}
              value={service.name}
              onChange={() => {}}
              disabled
            />

            <FormTextarea
              label={t("services.description", "Descripción")}
              value={service.description ?? ""}
              onChange={() => {}}
              disabled
              rows={4}
            />

            <div className="grid grid-cols-2 gap-6">
              <FormSelect
                label={t("services.category", "Categoría")}
                value={service.category?.id ?? ""}
                onChange={() => {}}
                options={categoryOptions}
                disabled
              />

              <FormToggle
                label={t("services.active", "Servicio Activo")}
                checked={service.isActive ?? false}
                onChange={() => {}}
                disabled
              />
            </div>
          </FormSection>

          <FormSection title={t("services.pricingSection", "Precio y Duración")} icon="payments">
            <div className="grid grid-cols-2 gap-6">
              <FormCurrencyInput
                label={t("services.price", "Precio Base")}
                value={service.price != null ? String(service.price) : ""}
                onChange={() => {}}
                disabled
              />

              <FormDurationSelect
                label={t("services.duration", "Duración estimada")}
                value={service.durationMinutes ?? 45}
                onChange={() => {}}
                disabled
              />
            </div>
          </FormSection>
        </div>
      </FormLayout>

      <ConfirmModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        title={t("services.deleteTitle", "Eliminar servicio")}
        message={t(
          "services.deleteMessage",
          `¿Estás seguro de que deseas eliminar "${service.name}"? Esta acción no se puede deshacer.`,
        )}
        confirmLabel={deleting ? t("common.deleting", "Eliminando...") : t("common.delete", "Eliminar")}
        cancelLabel={t("common.cancel", "Cancelar")}
        variant="danger"
      />
    </>
  );
}
