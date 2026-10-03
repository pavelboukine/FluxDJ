import { Card, CardContent } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { createGear } from "../actions";
import { GearFields } from "../gear-fields";

export default async function NewGear({ params }: PageProps<"/staff/[tenant]/gear/new">) {
  const { tenant: slug } = await params;
  const { tenant } = await requireStaff(slug);
  const categories = Object.keys((tenant.tax_categories ?? {}) as Record<string, unknown>);
  return (
    <>
      <PageHeader title="New gear item" description="Add photos and videos after saving." />
      <Card>
        <CardContent>
          <ActionForm action={createGear.bind(null, slug)} submitLabel="Create gear item">
            <GearFields taxCategories={categories} isNew />
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
