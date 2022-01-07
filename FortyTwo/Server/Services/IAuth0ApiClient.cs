using FortyTwo.Shared.DTO;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace FortyTwo.Server.Services
{
    public interface IAuth0ApiClient
    {
        Task<List<User>> GetUsersAsync();
        Task<List<User>> GetUsersAsync(List<string> userIds);
    }
}
