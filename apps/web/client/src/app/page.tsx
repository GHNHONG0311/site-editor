import { redirect } from 'next/navigation';

// The marketing landing page is not part of this tool; go straight to the projects dashboard.
export default function Main() {
    redirect('/projects');
}
