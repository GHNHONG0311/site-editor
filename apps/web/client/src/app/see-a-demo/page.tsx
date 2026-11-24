import { redirect } from 'next/navigation';

// The upstream "book a demo" page is not part of this tool.
export default function SeeADemo() {
    redirect('/projects');
}
