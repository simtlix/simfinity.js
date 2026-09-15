"use client";

import Image from "next/image";
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
  FormActions,
} from "@/components/shared";
import { useT } from "@/hooks/useT";
import { useFormState } from "@/hooks/useFormState";
import { useBarbershop } from "@/lib/barbershopContext";

type Category = { id: string; name: string };
type AssignedProfessional = { id: string; name: string; photoUrl?: string };

type ServiceForm = {
  name: string;
  description: string;
  categoryId: string;
  durationMinutes: number;
  price: string;
  isActive: boolean;
  imageUrl: string;
};

const INITIAL_VALUES: ServiceForm = {
  name: "",
  description: "",
  categoryId: "",
  durationMinutes: 45,
  price: "",
  isActive: true,
  imageUrl: "",
};

const SERVICE_FIELDS = "id name description price durationMinutes isActive category { id name } imageUrl";

export default function EditServicePage() {
  const client = useSimfinityClient();
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const t = useT("dashboard");
  const { selectedBarbershop } = useBarbershop();

  const { values, errors, setValue, setValues, setError, clearErrors } = useFormState(INITIAL_VALUES);
  const [categories, setCategories] = useState<Category[]>([]);
  const [assignedProfessionals, setAssignedProfessionals] = useState<AssignedProfessional[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadingData, setLoadingData] = useState(true);

  useEffect(() => {
    if (!selectedBarbershop?.id) return;
    (async () => {
      try {
        const [serviceRow, catResult, pros] = await Promise.all([
          client.getById("service", id, SERVICE_FIELDS),
          client
            .find("serviceCategory")
            .fields("id name")
            .where("barbershop", [{ path: "id", operator: "EQ", value: selectedBarbershop.id }])
            .exec(),
          client
            .find("professional")
            .fields("id name photoUrl services { service { id } }")
            .where("barbershop", [{ path: "id", operator: "EQ", value: selectedBarbershop.id }])
            .exec(),
        ]);

        const service = serviceRow as {
          name?: string;
          description?: string;
          category?: Category;
          durationMinutes?: number;
          price?: unknown;
          isActive?: boolean;
          imageUrl?: string;
        } | null;

        if (service) {
          const cat = service.category;
          setValues({
            name: service.name ?? "",
            description: service.description ?? "",
            categoryId: cat?.id ?? "",
            durationMinutes: service.durationMinutes ?? 45,
            price: service.price != null ? String(service.price) : "",
            isActive: service.isActive ?? true,
            imageUrl: service.imageUrl ?? "",
          });
        }

        setCategories(catResult as Category[]);

        const allPros = (pros ?? []) as (AssignedProfessional & { services?: { service: { id: string } }[] })[];
        const assigned = allPros.filter((p) =>
          p.services?.some((ps) => ps.service.id === id),
        );
        setAssignedProfessionals(assigned);
      } catch {
        /* keep defaults */
      } finally {
        setLoadingData(false);
      }
    })();
  }, [client, id, setValues, selectedBarbershop?.id]);

  function validate(): boolean {
    clearErrors();
    let valid = true;
    if (!values.name.trim()) {
      setError("name", t("validation.required", "Campo requerido"));
      valid = false;
    }
    if (!values.price || Number(values.price) <= 0) {
      setError("price", t("validation.invalidPrice", "Precio inválido"));
      valid = false;
    }
    return valid;
  }

  async function handleSubmit() {
    if (!validate()) return;
    setSaving(true);
    try {
      await client.update("service", id, {
        name: values.name,
        description: values.description || undefined,
        ...(values.categoryId ? { category: { id: values.categoryId } } : {}),
        durationMinutes: values.durationMinutes,
        price: Number(values.price),
        isActive: values.isActive,
        imageUrl: values.imageUrl || undefined,
      });
      router.push("/dashboard/services");
    } catch {
      setError("name", t("services.saveError", "Error al guardar el servicio"));
    } finally {
      setSaving(false);
    }
  }

  if (loadingData) {
    return (
      <div className="flex items-center justify-center py-20">
        <span className="material-symbols-outlined text-primary text-3xl animate-spin">
          progress_activity
        </span>
      </div>
    );
  }

  const categoryOptions = categories.map((c) => ({ value: c.id, label: c.name }));

  return (
    <>
      <PageHeader
        title={t("services.edit", "Editar Servicio")}
        subtitle={values.name}
        breadcrumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: t("services.title", "Servicios"), href: "/dashboard/services" },
          { label: t("common.edit", "Editar") },
        ]}
      />

      <FormLayout
        sidebar={
          <div className="space-y-6">
            <FormSidePanel>
              <FormImageUpload
                label={t("services.image", "Imagen de Portada")}
                value={values.imageUrl}
                onChange={(url) => setValue("imageUrl", url)}
                variant="wide"
                hint={t("services.imageHint", "Arrastra o haz clic para subir")}
              />
            </FormSidePanel>

            <FormActions
              onCancel={() => router.push("/dashboard/services")}
              onSubmit={handleSubmit}
              submitLabel={t("services.update", "Actualizar Servicio")}
              cancelLabel={t("common.cancel", "Cancelar")}
              loading={saving}
            />
          </div>
        }
      >
        <div className="space-y-8">
          <FormSection title={t("services.dataSection", "Datos del Servicio")} icon="content_paste">
            <FormField
              label={t("services.name", "Nombre del Servicio")}
              value={values.name}
              onChange={(v) => setValue("name", v)}
              error={errors.name}
              placeholder={t("services.namePlaceholder", "Ej: Corte Editorial Premium")}
              required
            />

            <FormTextarea
              label={t("services.description", "Descripción")}
              value={values.description}
              onChange={(v) => setValue("description", v)}
              placeholder={t("services.descriptionPlaceholder", "Describe la experiencia del servicio...")}
              rows={4}
            />

            <div className="grid grid-cols-2 gap-6">
              <FormSelect
                label={t("services.category", "Categoría")}
                value={values.categoryId}
                onChange={(v) => setValue("categoryId", v)}
                options={categoryOptions}
                placeholder={t("services.selectCategory", "Seleccionar categoría")}
              />

              <FormToggle
                label={t("services.active", "Servicio Activo")}
                checked={values.isActive}
                onChange={(v) => setValue("isActive", v)}
              />
            </div>
          </FormSection>

          <FormSection title={t("services.pricingSection", "Precio y Duración")} icon="payments">
            <div className="grid grid-cols-2 gap-6">
              <FormCurrencyInput
                label={t("services.price", "Precio Base")}
                value={values.price}
                onChange={(v) => setValue("price", v)}
                error={errors.price}
                placeholder="0.00"
                required
              />

              <FormDurationSelect
                label={t("services.duration", "Duración estimada")}
                value={values.durationMinutes}
                onChange={(v) => setValue("durationMinutes", v)}
              />
            </div>
          </FormSection>

          <FormSection title={t("services.assignedProfessionals", "Profesionales Asignados")} icon="groups">
            {assignedProfessionals.length === 0 ? (
              <p className="text-sm text-on-surface/40 italic">
                {t("services.noProfessionals", "Ningún profesional tiene asignado este servicio.")}
              </p>
            ) : (
              <div className="space-y-2">
                {assignedProfessionals.map((pro) => (
                  <button
                    key={pro.id}
                    type="button"
                    onClick={() => router.push(`/dashboard/professionals/${pro.id}/edit`)}
                    className="flex items-center gap-3 w-full rounded-xl px-4 py-3 bg-surface-container-low/50 hover:bg-surface-container-high transition-colors text-left group"
                  >
                    <div className="relative w-8 h-8 rounded-full overflow-hidden bg-surface-container-high border border-outline-variant/20 flex-shrink-0">
                      {pro.photoUrl ? (
                        <Image
                          src={pro.photoUrl}
                          alt={pro.name}
                          fill
                          unoptimized
                          className="object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-primary text-xs font-bold">
                          {pro.name.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <span className="text-sm text-on-surface flex-1">{pro.name}</span>
                    <span className="material-symbols-outlined text-sm text-on-surface/30 group-hover:text-primary transition-colors">
                      arrow_forward
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-on-surface/30 mt-2">
              {t("services.assignHint", "Para asignar profesionales, edita cada profesional y selecciona este servicio.")}
            </p>
          </FormSection>
        </div>
      </FormLayout>
    </>
  );
}
