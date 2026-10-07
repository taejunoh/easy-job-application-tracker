/** @jest-environment jsdom */

import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ApplicationsPage from "@/app/applications/page";
import { useClientApi } from "@/hooks/use-client-api";

jest.mock("@/hooks/use-client-api", () => ({ useClientApi: jest.fn() }));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

const api = jest.fn();
const application = {
  id: "app-1",
  jobTitle: "Senior Engineer",
  company: "Acme Labs",
  status: "Applied",
  appliedDate: "2026-09-10T00:00:00.000Z",
  location: "New York",
  jobType: "Remote",
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useClientApi).mockReturnValue(api);
});

it("renders labeled search and native status and job type filters", async () => {
  api.mockResolvedValue([application]);
  render(createElement(ApplicationsPage));

  expect(screen.getByRole("heading", { name: "Applications" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Search applications" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Status" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Job type" })).toBeInTheDocument();
  await screen.findByText("Senior Engineer");
});

it("requests the exact combined search, status, and job type values", async () => {
  api.mockResolvedValue([application]);
  render(createElement(ApplicationsPage));
  await screen.findByText("Senior Engineer");

  fireEvent.change(screen.getByRole("textbox", { name: "Search applications" }), {
    target: { value: "Engineer" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
    target: { value: "Interview" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Job type" }), {
    target: { value: "Remote" },
  });

  await waitFor(() => {
    expect(api).toHaveBeenLastCalledWith(
      "/api/applications?search=Engineer&status=Interview&jobType=Remote",
    );
  });
});

it("keeps filter values after a request failure and shows an alert", async () => {
  api.mockResolvedValue([application]);
  render(createElement(ApplicationsPage));
  await screen.findByText("Senior Engineer");
  api.mockImplementation((url: string) =>
    url.includes("Engineer")
      ? Promise.reject(new Error("Unavailable"))
      : Promise.resolve([application]),
  );

  const search = screen.getByRole("textbox", { name: "Search applications" });
  const status = screen.getByRole("combobox", { name: "Status" });
  const jobType = screen.getByRole("combobox", { name: "Job type" });
  fireEvent.change(search, { target: { value: "Engineer" } });
  fireEvent.change(status, { target: { value: "Interview" } });
  fireEvent.change(jobType, { target: { value: "Remote" } });

  expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
  expect(search).toHaveValue("Engineer");
  expect(status).toHaveValue("Interview");
  expect(jobType).toHaveValue("Remote");
});
