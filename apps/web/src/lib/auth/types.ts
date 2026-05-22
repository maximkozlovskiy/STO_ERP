export interface AuthEmployee {
  id: string;
  orgId: string;
  firstName: string;
  lastName: string;
  role: string;
}

export interface AuthState {
  employee: AuthEmployee | null;
  accessToken: string | null;
  isLoading: boolean;
}
