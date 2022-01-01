using System.Linq;
using System.Security.Claims;

namespace FortyTwo.Shared.Extensions
{
    public static class ClaimsPrincipalExtensions
    {
        public static string GetUserId(this ClaimsPrincipal claimsPrincipal)
            => claimsPrincipal?.Claims.SingleOrDefault(c => c.Type == "sub")?.Value;
    }
}
