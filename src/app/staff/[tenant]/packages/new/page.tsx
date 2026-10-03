import { Card, CardContent } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { createPackage } from "../actions";
import { PackageFields } from "../package-fields";

export default async function NewPackage({ params }: PageProps<"/staff/[tenant]/packages/new">) {
  const { tenant: slug } = await params;
  const { tenant } = await requireStaff(slug);
  return (
    <>
      <PageHeader title="New package" description="Choose the included gear after saving." />
      <Card>
        <CardContent>
          <ActionForm action={createPackage.bind(null, slug)} submitLabel="Create package">
            <PackageFields taxCategories={Object.keys((tenant.tax_categories ?? {}) as object)} isNew />
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
