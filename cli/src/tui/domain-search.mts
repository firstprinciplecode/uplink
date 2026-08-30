import { runDomainSearch } from "./DomainSearch.tsx";

runDomainSearch()
  .then((message) => {
    if (message) console.log(message);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
