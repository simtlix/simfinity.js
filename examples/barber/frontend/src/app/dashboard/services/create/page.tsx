"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
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

export default function CreateServicePage() {
  const client = useSimfinityClient();
  const router = useRouter();
  const t = useT("dashboard");
  const { selectedBarbershop } = useBarbershop();
  const { values, errors, setValue, setError, clearErrors } = useFormState(INITIAL_VALUES);
  const [categories, setCategories] = useState<Category[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!selectedBarbershop?.id) return;
    (async () => {
      try {
        const result = await client
          .find("serviceCategory")
          .fields("id name")
          .where("barbershop", [{ path: "id", operator: "EQ", value: selectedBarbershop.id }])
          .exec();
        setCategories(result as Category[]);
      } catch {
        setCategories([]);
      }
    })();
  }, [client, selectedBarbershop?.id]);

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
      await client.add("service", {
        name: values.name,
        description: values.description || undefined,
        ...(values.categoryId ? { category: { id: values.categoryId } } : {}),
        durationMinutes: values.durationMinutes,
        price: Number(values.price),
        isActive: values.isActive,
        imageUrl: values.imageUrl || undefined,
        barbershop: { id: selectedBarbershop!.id },
      });
      router.push("/dashboard/services");
    } catch {
      setError("name", t("services.saveError", "Error al guardar el servicio"));
    } finally {
      setSaving(false);
    }
  }

  const categoryOptions = categories.map((c) => ({ value: c.id, label: c.name }));

  return (
    <>
      <PageHeader
        title={t("services.create", "Nuevo Servicio")}
        subtitle={t("services.createSubtitle", "Define los detalles del nuevo servicio")}
        breadcrumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: t("services.title", "Servicios"), href: "/dashboard/services" },
          { label: t("services.new", "Nuevo") },
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
              submitLabel={t("services.save", "Guardar Servicio")}
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
        </div>
      </FormLayout>
    </>
  );
}
