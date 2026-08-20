import SupplierPaymentCardPage from './PageClient';

// Static export: generate a placeholder shell; actual id is read client-side via useParams()
export function generateStaticParams() {
  return [{ id: '_' }];
}

export default function Page() {
  return <SupplierPaymentCardPage />;
}
