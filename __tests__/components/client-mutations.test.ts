import { updateApplicationStatus } from "@/app/applications/page";
import { saveSettings } from "@/app/settings/page";
import {
  deleteApplication,
  saveApplicationChanges,
} from "@/components/ApplicationDetail";
import { saveNewApplication } from "@/components/UrlInput";
import { ClientApiError, type ClientApi } from "@/lib/client-api";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));

const rejectedRequest = jest.fn(() =>
  Promise.reject(new ClientApiError(400, "invalid_request", "Invalid request")),
) as ClientApi;

describe("client mutations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not refresh application status after a 4xx response", async () => {
    const refresh = jest.fn();

    await expect(
      updateApplicationStatus(
        rejectedRequest,
        refresh,
        "app-1",
        "Interview",
      ),
    ).rejects.toBeInstanceOf(ClientApiError);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not show a saved application state after a 4xx response", async () => {
    const markSaved = jest.fn();

    await expect(
      saveApplicationChanges(rejectedRequest, markSaved, "app-1", {
        status: "Offer",
      }),
    ).rejects.toBeInstanceOf(ClientApiError);

    expect(markSaved).not.toHaveBeenCalled();
  });

  it("does not navigate after a failed delete", async () => {
    const navigate = jest.fn();

    await expect(
      deleteApplication(rejectedRequest, navigate, "app-1"),
    ).rejects.toBeInstanceOf(ClientApiError);

    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not show settings success after a 4xx response", async () => {
    const markSaved = jest.fn();

    await expect(
      saveSettings(rejectedRequest, markSaved, { llmProvider: "openai" }),
    ).rejects.toBeInstanceOf(ClientApiError);

    expect(markSaved).not.toHaveBeenCalled();
  });

  it("keeps API-key status false after a fresh profile-only save", async () => {
    const request = jest.fn(() =>
      Promise.resolve({ hasApiKey: false }),
    ) as ClientApi;
    const markSaved = jest.fn();

    await saveSettings(request, markSaved, {
      llmProvider: "openai",
      linkedinUrl: "https://linkedin.com/in/example",
    });

    expect(markSaved).toHaveBeenCalledWith(false);
  });

  it("does not clear the add-application form after a 4xx response", async () => {
    const clearForm = jest.fn();

    await expect(
      saveNewApplication(rejectedRequest, clearForm, {
        url: "https://jobs.example/1",
        jobTitle: "Engineer",
        company: "Example",
      }),
    ).rejects.toBeInstanceOf(ClientApiError);

    expect(clearForm).not.toHaveBeenCalled();
  });
});
