export interface ApplicationSummary {
  id: string;
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: string;
  updatedAt?: string | null;
  location: string | null;
  jobType: string | null;
  nextStep?: string | null;
  nextStepDate?: string | null;
}

export interface ApplicationRecord extends ApplicationSummary {
  url: string;
  description: string | null;
  notes: string | null;
  salary: string | null;
}
