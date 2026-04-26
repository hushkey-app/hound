import { Head } from "@hushkey/howl/runtime";
import type { JSX } from "preact/jsx-dev-runtime";

export default function Error({ error }: { error: unknown }): JSX.Element {
  const errorMap = {
    404: "Not Found",
    500: "Internal Server Error",
    403: "Forbidden",
    401: "Unauthorized",
    400: "Bad Request",
  };
  const errorMessage =
    errorMap[(error as { status: number }).status as keyof typeof errorMap] ||
    "Unknown error";
  const status = (error as { status: number }).status || 500;

  console.log("error", error);

  return (
    <>
      <Head>
        <title>Error {errorMessage}</title>
      </Head>
      {/* center */}
      <div class="pt-20 pb-40 flex justify-center px-5">
        <div class="text-center w-full max-w-2xl">
          <h1 class="text-6xl sm:text-6xl font-bold mb-4 text-error">{status}</h1>
          <h2 class="text-3xl sm:text-3xl font-semibold mb-2">Oops!</h2>
          <p class="text-lg sm:text-lg mb-3 text-base-content/70">{errorMessage}</p>
          <p class="text-base mb-8 text-base-content/60 leading-relaxed">
            The page you're looking for could not be found. We appreciate if you
            could go back to the home page to continue browsing.
          </p>
          <a
            href="/"
            class="btn btn-primary btn-md rounded-lg mt-4"
            f-client-nav
          >
            Go Back Home
          </a>
        </div>
      </div>
    </>
  );
}
