using System.Linq;
using FortyTwo.Shared.Models.Security;
using Microsoft.AspNetCore.Http;

namespace FortyTwo.Server.Services.Security
{
    public class HttpContextUserId : UserId
    {
        private readonly IHttpContextAccessor _httpContextAccessor;

        public HttpContextUserId(IHttpContextAccessor httpContextAccessor)
        {
            _httpContextAccessor = httpContextAccessor;
        }

        public override string GetUserId()
            => _httpContextAccessor.HttpContext.User?.Claims.SingleOrDefault(c => c.Type == "sub")?.Value;
    }
}
