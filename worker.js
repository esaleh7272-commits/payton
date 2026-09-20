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
          "https://toncenter.com/api/v2/getWalletInformation" +
          "?address=" +
          encodeURIComponent(TARGET);

        const response = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "X-API-Key": env.TONCENTER_API_KEY
          }
        });

        const data = await response.json();

        if (!response.ok || !data.ok) {
          return new Response(
            "TONCENTER ERROR\n\n" +
            JSON.stringify(data, null, 2),
            { status: 500 }
          );
        }

        const result = data.result || {};

        const wallet =
          result.wallet === true;

        const walletType =
          result.wallet_type || "unknown";

        const walletId =
          result.wallet_id !== undefined
            ? String(result.wallet_id)
            : "unknown";

        const seqno =
          result.seqno !== undefined
            ? String(result.seqno)
            : "unknown";

        const accountState =
          result.account_state || "unknown";

        const balance =
          result.balance !== undefined
            ? String(result.balance)
            : "unknown";

        return new Response(
`PAYTON WALLET CHECK

Address:
${TARGET}

Wallet:
${wallet}

Wallet type:
${walletType}

Wallet ID:
${walletId}

Seqno:
${seqno}

Account state:
${accountState}

Balance:
${balance}

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
