const TARGET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const CHECK_PATH =
  "/__wallet_type_check_739182";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      url.pathname === CHECK_PATH
    ) {
      try {
        if (!env.TONCENTER_API_KEY) {
          return new Response(
            "ERROR: TONCENTER_API_KEY secret is missing",
            { status: 500 }
          );
        }

        const apiUrl =
          "https://toncenter.com/api/v3/accountStates" +
          "?address=" +
          encodeURIComponent(TARGET);

        const response = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "X-API-Key": env.TONCENTER_API_KEY
          }
        });

        const data = await response.json();

        if (!response.ok) {
          return new Response(
            "TONCENTER ERROR\n\n" +
            JSON.stringify(data, null, 2),
            { status: 500 }
          );
        }

        if (
          !data.accounts ||
          data.accounts.length === 0
        ) {
          return new Response(
            "NO ACCOUNT DATA FOUND",
            { status: 404 }
          );
        }

        const account = data.accounts[0];

        const status =
          account.account_status ||
          "unknown";

        const codeHash =
          account.code_hash ||
          "unknown";

        const interfaces =
          account.interfaces || [];

        const interfaceText =
          Array.isArray(interfaces)
            ? interfaces.join(", ").toLowerCase()
            : String(interfaces).toLowerCase();

        let walletType = "UNKNOWN";

        if (
          interfaceText.includes("v5") ||
          interfaceText.includes("wallet_v5")
        ) {
          walletType = "V5R1";
        } else if (
          interfaceText.includes("v4") ||
          interfaceText.includes("wallet_v4")
        ) {
          walletType = "V4R2";
        } else if (
          interfaceText.includes("v3")
        ) {
          walletType = "V3";
        }

        return new Response(
`PAYTON WALLET CHECK

Address:
${TARGET}

Account status:
${status}

Wallet type:
${walletType}

Code hash:
${codeHash}

Interfaces:
${
  Array.isArray(interfaces)
    ? interfaces.join(", ")
    : String(interfaces)
}

No transaction was sent.
No mnemonic was used.`,
          {
            headers: {
              "Content-Type":
                "text/plain; charset=UTF-8"
            }
          }
        );

      } catch (error) {
        console.error(error);

        return new Response(
          "ERROR\n\n" +
          String(
            error?.message || error
          ),
          { status: 500 }
        );
      }
    }

    return new Response(
      "PAYTON wallet check is running!"
    );
  }
};
