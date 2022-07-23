using FortyTwo.Shared.DTO;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace FortyTwo.Server.Services
{
    public interface IAuth0ApiClient
    {
        Task<User> GetUserAsync(string userId);
        Task<List<User>> GetUsersAsync();
        Task<List<User>> GetUsersAsync(List<string> userIds);
        Task UpdateUserAsync(string userId, UserPatch patch);
    }
}
